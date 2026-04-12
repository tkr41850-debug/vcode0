import { type ComposeOptions, composeApplication } from '@root/compose';

export async function main(options: ComposeOptions = {}): Promise<void> {
  const app = composeApplication(options);
  await app.start();
}
