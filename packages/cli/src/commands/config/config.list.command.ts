/**
 * Config list command - List configured accounts
 */

import fs from 'node:fs';
import type { Command } from 'commander';
import { CONFIG_PATH, type SalesBinderConfig } from '@salesbinder/sdk';

/**
 * Register config list command
 */
export function registerConfigList(program: Command): void {
  program
    .command('config:list')
    .description(`List all configured SalesBinder accounts

Example:
  salesbinder config:list

Shows:
  - All configured account names
  - Subdomain for each account
  - API version
  - Which account is set as default

Use --account flag with other commands to switch accounts:
  salesbinder items list --account production`)
    .action(() => {
      try {
        if (!fs.existsSync(CONFIG_PATH)) {
          console.log(
            JSON.stringify(
              {
                configured: false,
                message: 'No configuration found',
                hint: `Run: salesbinder config:init`,
              },
              null,
              2
            )
          );
          return;
        }

        const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(content) as SalesBinderConfig;

        const accounts = Object.entries(config.accounts).map(([name, acct]) => ({
          name,
          subdomain: acct.subdomain,
          apiVersion: acct.apiVersion,
          isDefault: name === config.defaultAccount,
        }));

        console.log(JSON.stringify({ configured: true, defaultAccount: config.defaultAccount, accounts }, null, 2));
      } catch (error) {
        console.error(
          JSON.stringify({
            error: true,
            message: (error as Error).message,
          })
        );
        process.exit(1);
      }
    });
}
