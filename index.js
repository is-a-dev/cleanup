require("dotenv").config()

const axios = require("axios");
const chalk = require("chalk");
const { Octokit } = require("@octokit/rest");

const apiUrl = "https://raw-api.is-a.dev";

let amountScanned = 0;

const domainsToSkip = [];
const usernamesToSkip = [
    "is-a-dev",
    "wdhdev",
    "21Z",
    "DEV-DIBSTER",
    "iostpa",
    "orangci",
    "Stef-00012",
    "SX-9"
];

async function fetchData() {
    try {
        const response = await axios.get(apiUrl);
        let data = response.data;

        amountScanned = data.length;

        console.log(chalk.blueBright(`[INFO] Started scanning ${amountScanned} domains...`));

        const invalidDomains = [];
        const invalidDomainData = [];

        for (let entry of data) {
            const domain = entry.domain;
            const domainUrl = `https://${domain}`;

            console.log(chalk.blue(`[INFO] Checking ${domain}...`));

            // Skip if the domain is in the skip list
            if (domainsToSkip.includes(entry.subdomain)) {
                console.log(chalk.yellow(`[INFO] ${domain}: Skipping domain as it is on the domain skip list.`));
                continue;
            }

            // Skip if the owner is in the skip list
            if (usernamesToSkip.includes(entry.owner.username)) {
                console.log(chalk.yellow(`[INFO] ${domain}: Skipping domain as the owner is on the username skip list.`));
                continue;
            }

            // Skip if the domain is not pointing to a website
            if (!entry.record.A && !entry.record.AAAA && !entry.record.CNAME && !entry.record.URL) {
                console.log(chalk.yellow(`[INFO] ${domain}: Skipping domain as it is not used for a website.`));
                continue;
            }

            // Skip if the domain has email records
            if (entry.record.MX) {
                console.log(chalk.yellow(`[INFO] ${domain}: Skipping domain as it is used for emails.`));
                continue;
            }

            // Skip if the domain has NS records
            if (entry.record.NS) {
                console.log(chalk.yellow(`[INFO] ${domain}: Skipping domain as it is has delegated nameservers.`));
                continue;
            }

            // If nested subdomain, check root subdomain exists
            if (entry.subdomain.split(".").length > 1) {
                const rootSubdomain = entry.subdomain.split(".").pop();

                if (!data.some((e) => e.subdomain === rootSubdomain)) {
                    console.log(chalk.red(`[ERROR] ${domain}: Root subdomain does not exist, deleting nested subdomain.`));

                    entry.error = "Root subdomain does not exist";

                    invalidDomains.push(entry.subdomain);
                    invalidDomainData.push(entry);
                    continue;
                }

                // Remove if root domain has NS records
                const rootSubdomainData = data.find((e) => e.subdomain === rootSubdomain);

                if (rootSubdomainData.record.NS) {
                    console.log(chalk.red(`[ERROR] ${domain}: Root subdomain has delegated nameservers, deleting nested subdomain.`));

                    entry.error = "Root subdomain has delegated nameservers";

                    invalidDomains.push(entry.subdomain);
                    invalidDomainData.push(entry);
                    continue;
                }
            }

            try {
                await axios.head(entry.record.URL ? entry.record.URL : domainUrl, { timeout: 5000 });
            } catch (error) {
                // Re-attempt to double check the domain is invalid
                try {
                    await axios.head(entry.record.URL ? entry.record.URL : domainUrl, { timeout: 5000 });
                } catch (error) {
                    console.log(chalk.red(`[ERROR] ${domain}: ${error.message}`));

                    if(error.message) {
                        entry.error = error.message;

                        invalidDomains.push(entry.subdomain);
                        invalidDomainData.push(entry);
                    } else {
                        continue;
                    }
                }
            }
        }

        if (invalidDomains.length > 0) {
            await forkAndOpenPR(invalidDomains, invalidDomainData);
        } else {
            console.log(chalk.green("[INFO] No invalid domains found."));
        }
    } catch (error) {
        console.log(chalk.red(`[ERROR] Fetching data: ${error.message}`));
    }
}

async function forkAndOpenPR(invalidDomains, invalidDomainData) {
    const octokit = new Octokit({ auth: process.env.githubToken });

    try {
        // Fork the repository
        const forkResponse = await octokit.repos.createFork({
            owner: "is-a-dev",
            repo: "register",
        });

        console.log(chalk.blue(`[INFO] Forked is-a-dev/register to ${forkResponse.data.full_name}`));

        console.log(chalk.blue(`[INFO] Deleting invalid domains...`));

        // Make changes in the forked repository
        await deleteInvalidFiles(invalidDomains, forkResponse.data.full_name);

        console.log(chalk.blue(`[INFO] Opening pull request...`));

        // Open a pull request
        const prResponse = await octokit.pulls.create({
            owner: "is-a-dev",
            repo: "register",
            title: "automated domain cleanup",
            body: `Scanned **${amountScanned}** domain${amountScanned === 1 ? "" : "s"} and found **${invalidDomains.length}** invalid domain${invalidDomains.length === 1 ? "" : "s"}.

| Domain | Owner | Error Message |
|-|-|-|
${invalidDomainData.map((i) => `| ${i.domain} | @${i.owner.username} | \`${i.error}\` |`).join("\n")}
`,
            head: `${process.env.githubUsername}:main`,
            base: "main",
        })

        console.log(chalk.green(`[INFO] Pull request opened: ${prResponse.data.html_url}`));

        process.exit(0);
    } catch (error) {
        console.log(chalk.red(`[ERROR] Forking repository, creating branch, opening PR or sending emails: ${error.message}`));
        process.exit(1);
    }
}

async function deleteInvalidFiles(invalidDomains, repoFullName) {
    const octokit = new Octokit({ auth: process.env.githubToken });

    for (const domain of invalidDomains) {
        const fileName = `domains/${domain}.json`;

        try {
            const fileContent = await octokit.repos.getContent({
                owner: "is-a-dev",
                repo: "register",
                path: fileName,
            });

            const sha = fileContent.data.sha;

            await octokit.repos.deleteFile({
                owner: repoFullName.split("/")[0],
                repo: repoFullName.split("/")[1],
                branch: "main",
                path: fileName,
                message: `chore: remove ${domain}.is-a.dev`,
                sha: sha,
            });

            console.log(chalk.blue(`[INFO] Deleted ${domain}.is-a.dev`));
        } catch (error) {
            console.log(chalk.red(`[ERROR] Deleting ${domain}: ${error.message}`));
        }
    }
}

fetchData();

setInterval(() => console.log(chalk.yellow("[INFO] Heartbeat check")), 120 * 1000);
