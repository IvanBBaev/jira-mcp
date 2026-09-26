// ---------------------------------------------------------------------------
// api/adapters.ts — which api-ring adapter a deployment gets (D106).
//
// Its own module because `api/datacenter.ts` imports `CLOUD_API` from
// `api/port.ts`; choosing between the two there would be an import cycle.
// ---------------------------------------------------------------------------

import type { JiraDeployment } from '../core/types.js';
import { DATACENTER_API } from './datacenter.js';
import { CLOUD_API } from './port.js';
import type { JiraApi } from './port.js';

/** The adapter the server runs for a deployment. */
export function adapterFor(deployment: JiraDeployment): JiraApi {
  switch (deployment) {
    case 'cloud':
      return CLOUD_API;
    case 'datacenter':
      return DATACENTER_API;
  }
}
