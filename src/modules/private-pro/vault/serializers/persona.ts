import { personaSyncDelete, personaSyncSnapshot, personaSyncSubscribe, personaSyncUpsert } from '../../../../apps/personas/store-app-personas';
import { parseSyncPersona, serializeSyncPersona } from '~/modules/private-pro/sync/privatePro.sync.serialize';
import { SyncPersonaSchema, type SyncPersona } from '~/modules/private-pro/sync/privatePro.sync.schemas';

import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';


export const privateProVaultPersonaSerializer: PrivateProVaultLogicalSerializer<SyncPersona> = {
  recordType: 'persona',
  schemaVersion: 1,
  schema: SyncPersonaSchema.strict(),
  logicalId: value => value.persona.id,
  snapshot: () => personaSyncSnapshot().map(persona => ({ logicalId: persona.id, value: serializeSyncPersona(persona) })),
  apply: (_logicalId, value) => personaSyncUpsert(parseSyncPersona(value)),
  remove: personaSyncDelete,
  subscribe: personaSyncSubscribe,
};
