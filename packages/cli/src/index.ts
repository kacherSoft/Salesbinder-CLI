/**
 * Main CLI entry point
 */

import { Command } from 'commander';
import { registerConfigInit } from './commands/config/config.init.command.js';
import { registerConfigList } from './commands/config/config.list.command.js';
import { registerItemsCommands } from './commands/items/items.commands.js';
import { registerCustomersCommands } from './commands/customers/customers.commands.js';
import { registerDocumentsCommands } from './commands/documents/documents.commands.js';
import { registerLocationsCommands } from './commands/locations/locations.commands.js';
import { registerCategoriesCommands } from './commands/categories/categories.commands.js';
import { registerItemSalesCommand } from './commands/analytics/item-sales.command.js';
import { registerCacheCommands } from './commands/cache/cache.commands.js';

/**
 * Create and configure CLI program
 */
export function createProgram(): Command {
  const program = new Command();

  program
    .name('salesbinder')
    .description(`CLI tool for SalesBinder API

Quick Start:
  1. Configure:   salesbinder config:init --subdomain <name> --api-key <key>
  2. List items:  salesbinder items list
  3. Get help:    salesbinder <command> --help

Available Commands:
  config:init     Initialize CLI configuration
  config:list     List configured accounts
  items           Manage inventory items
  customers       Manage customers, prospects, suppliers
  documents       Manage estimates, invoices, purchase orders
  locations       Manage inventory locations
  categories      Manage item categories
  analytics       Sales analytics and reporting
  cache           Local cache management

Global Options:
  --account <name>   Use specific account from config file

Examples:
  salesbinder items list --limit 10
  salesbinder items get <item-id>
  salesbinder customers list --context 2
  salesbinder documents list --customer <id>
  salesbinder analytics item-sales <item-id>
  salesbinder cache sync

For more help: https://github.com/yourusername/salesbinder-cli`)
    .version('0.1.0')
    .option('--account <name>', 'Account name to use (from config file)');

  // Register config commands
  registerConfigInit(program);
  registerConfigList(program);

  // Register resource commands
  registerItemsCommands(program);
  registerCustomersCommands(program);
  registerDocumentsCommands(program);
  registerLocationsCommands(program);
  registerCategoriesCommands(program);

  // Register analytics and cache commands
  registerItemSalesCommand(program);
  registerCacheCommands(program);

  return program;
}
