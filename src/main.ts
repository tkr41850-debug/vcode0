import { composeApplication } from '@root/compose';

export async function main(): Promise<void> {
  const app = composeApplication();
  await app.start();
}
