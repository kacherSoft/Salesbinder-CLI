import { writeContainerConfig } from './container-config.js';
import { validateSchedulerEnvironment } from './scheduler-config.js';

try {
  const config = validateSchedulerEnvironment(process.env);
  if (config.disabled) {
    console.log('SalesBinder scheduler is explicitly disabled.');
  } else {
    writeContainerConfig(config);
    console.log('SalesBinder config initialized.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Container configuration failed.');
  process.exitCode = 1;
}
