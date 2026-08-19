import type { PrivateProVaultLogicalSerializer } from '../privatePro.vault.serializers';
import { privateProSyncSettingsSerializer } from '../../sync/serializers/settings';


export const privateProVaultSettingsSerializer = privateProSyncSettingsSerializer as unknown as PrivateProVaultLogicalSerializer<unknown>;
