import type { Migration } from '@persistence/migrations/index';

export const Migration008IntegrationPostRebaseSha: Migration = {
  id: '008_integration_post_rebase_sha',
  description:
    'Add integration_state.feature_branch_post_rebase_sha so the reconciler can match the post-rebase feature tip against a merge commit parent after a crash between git merge and DB commit.',
  up(context): void {
    context.execute(
      'ALTER TABLE integration_state ADD COLUMN feature_branch_post_rebase_sha TEXT',
    );
  },
};
