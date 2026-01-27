/**
 * Config init command - Initialize SalesBinder CLI configuration
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { CONFIG_PATH } from '@salesbinder/sdk';

/**
 * Register config init command
 */
export function registerConfigInit(program: Command): void {
  program
    .command('config:init')
    .description(`Initialize CLI configuration

Examples:
  salesbinder config:init
  salesbinder config:init --subdomain acme --api-key <key>
  salesbinder config:init --subdomain acme --api-key <key> --account-name production

This command:
  - Prompts for subdomain and API key (if not provided)
  - Creates ~/.salesbinder/config.json with 0600 permissions
  - Stores credentials securely for future commands

To get your API key:
  1. Login to your SalesBinder account
  2. Go to Settings > API Access
  3. Generate or copy your API key

Options:
  --subdomain     Your SalesBinder subdomain (e.g., "acme" from acme.salesbinder.com)
  --api-key       Your SalesBinder API key from Settings > API Access
  --account-name  Account name for this configuration (default: "default")`)
    .option('--subdomain <subdomain>', 'Your SalesBinder subdomain (e.g., "acme" from acme.salesbinder.com)')
    .option('--api-key <key>', 'Your SalesBinder API key')
    .option('--account-name <name>', 'Account name for this configuration', 'default')
    .action(async (options) => {
      try {
        // Check if config already exists
        if (fs.existsSync(CONFIG_PATH)) {
          console.error(
            JSON.stringify({
              error: true,
              message: `Configuration already exists at ${CONFIG_PATH}`,
              hint: 'Edit the file directly or remove it first',
            })
          );
          process.exit(1);
        }

        // Prompt for missing values
        const subdomain = options.subdomain || await promptRequired('Subdomain (e.g., "acme")');
        const apiKey = options.apiKey || await promptRequired('API Key');

        // Create config directory
        const configDir = path.dirname(CONFIG_PATH);
        fs.mkdirSync(configDir, { recursive: true });

        // Create config file
        const config = {
          defaultAccount: options.accountName,
          accounts: {
            [options.accountName]: {
              subdomain,
              apiKey,
              apiVersion: '2.0',
              timeout: 30000,
            },
          },
        };

        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));

        // Set permissions to 0600 (owner read/write only)
        fs.chmodSync(CONFIG_PATH, 0o600);

        console.log(
          JSON.stringify(
            {
              success: true,
              message: 'Configuration saved successfully',
              config: CONFIG_PATH,
              account: options.accountName,
            },
            null,
            2
          )
        );
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

/**
 * Prompt user for required value
 */
async function promptRequired(label: string): Promise<string> {
  // For non-interactive use, error out
  if (!process.stdin.isTTY) {
    throw new Error(`Missing required value: ${label}. Use --${label.toLowerCase().replace(' ', '-')} flag.`);
  }

  // Simple readline prompt
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const answer = await rl.question(`${label}: `);
  rl.close();

  if (!answer.trim()) {
    throw new Error(`${label} is required`);
  }

  return answer.trim();
}
