import { composeApplication } from '@root/compose';

export async function main(): Promise<void> {
  const app = await composeApplication();
  await app.start();
}
