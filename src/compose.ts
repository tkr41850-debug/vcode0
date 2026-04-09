import type { GvcApplication } from '@app/index';

export interface ApplicationComposition {
  app: GvcApplication;
}

export function composeApplication(): ApplicationComposition {
  throw new Error('Not implemented.');
}
