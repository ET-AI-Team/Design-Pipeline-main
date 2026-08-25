/**
 * Side-effect import barrel. Importing this file (once, at server
 * startup) registers every pipeline stage into the Orchestrator's
 * registry before any job can be dispatched.
 */
import './base-layer-classification.stage';
import './base-asset.stage';
import './logo-composite.stage';
import './poster.stage';
import './dimension.stage';

export { listRegisteredStages } from '../orchestrator/stage-registry';
