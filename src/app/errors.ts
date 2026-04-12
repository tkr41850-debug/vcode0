/**
 * Thrown when a port method is called whose real implementation has not yet
 * been wired up. The compose root installs stub ports during the bootstrap
 * phases; touching one of their methods at runtime should fail fast with a
 * specific feature name so the caller knows exactly which surface still needs
 * implementation.
 */
export class NotYetWiredError extends Error {
  readonly featureName: string;

  constructor(featureName: string) {
    super(`gvc0: '${featureName}' is not yet wired up`);
    this.name = 'NotYetWiredError';
    this.featureName = featureName;
  }
}
