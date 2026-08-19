import { personaSyncResetAll } from '../../../apps/personas/store-app-personas';
import { panesManagerResetPrivateProRuntime } from '../../../apps/chat/components/panes/store-panes-manager';
import { liveFileResetPrivateProRuntime } from '~/common/livefile/store-live-file';
import { loggerResetPrivateProRuntime } from '~/common/logger/store-logger';
import { logicSherpaResetPrivateProRuntime } from '~/common/logic/store-logic-sherpa';
import { scratchClipVaultReset } from '~/common/layout/optima/scratchclip/store-scratchclip';
import { chatSyncResetAll } from '~/common/stores/chat/store-chats';
import { folderVaultResetAll } from '~/common/stores/folders/store-chat-folders';
import { useModelsStore } from '~/common/stores/llms/store-llms';
import { metricsResetPrivateProRuntime } from '~/common/stores/metrics/store-metrics';
import { deviceResetPrivateProRuntime } from '~/common/stores/store-client';
import { themeVaultReset } from '~/common/stores/store-ui';
import { workspaceResetPrivateProRuntime } from '~/common/stores/workspace/store-client-workspace';
import { asrxVaultReset } from '~/modules/asrx/store-module-asrx';
import { googleVaultReset } from '~/modules/google/store-module-google';
import { speexVaultReset } from '~/modules/speex/store-module-speex';
import { shareVaultReset } from '~/modules/trade/link/store-share-link';

import {
  PRIVATE_PRO_SYNC_SETTINGS_AI_ID,
  PRIVATE_PRO_SYNC_SETTINGS_BEAM_ID,
  PRIVATE_PRO_SYNC_SETTINGS_BROWSING_ID,
  PRIVATE_PRO_SYNC_SETTINGS_CALL_ID,
  PRIVATE_PRO_SYNC_SETTINGS_CHAT_ID,
  PRIVATE_PRO_SYNC_SETTINGS_FOLDERS_ID,
  PRIVATE_PRO_SYNC_SETTINGS_IMAGE_ID,
  PRIVATE_PRO_SYNC_SETTINGS_PURPOSES_ID,
  PRIVATE_PRO_SYNC_SETTINGS_UI_ID,
  PRIVATE_PRO_SYNC_SETTINGS_UX_LABS_ID,
  privateProPortableAppSettingsReset,
} from './serializers/settings.portable';


export function clearPrivateProManagedRuntimeStores(): void {
  panesManagerResetPrivateProRuntime();
  liveFileResetPrivateProRuntime();
  loggerResetPrivateProRuntime();
  logicSherpaResetPrivateProRuntime();
  metricsResetPrivateProRuntime();
  deviceResetPrivateProRuntime();
  workspaceResetPrivateProRuntime();
  chatSyncResetAll();
  personaSyncResetAll();
  folderVaultResetAll();
  scratchClipVaultReset();
  useModelsStore.setState({ llms: [], sources: [], confServiceId: null, modelAssignments: {} });
  themeVaultReset();
  googleVaultReset();
  asrxVaultReset();
  speexVaultReset();
  shareVaultReset();
  for (const group of [
    PRIVATE_PRO_SYNC_SETTINGS_CALL_ID,
    PRIVATE_PRO_SYNC_SETTINGS_CHAT_ID,
    PRIVATE_PRO_SYNC_SETTINGS_PURPOSES_ID,
    PRIVATE_PRO_SYNC_SETTINGS_AI_ID,
    PRIVATE_PRO_SYNC_SETTINGS_UI_ID,
    PRIVATE_PRO_SYNC_SETTINGS_UX_LABS_ID,
    PRIVATE_PRO_SYNC_SETTINGS_BEAM_ID,
    PRIVATE_PRO_SYNC_SETTINGS_BROWSING_ID,
    PRIVATE_PRO_SYNC_SETTINGS_IMAGE_ID,
    PRIVATE_PRO_SYNC_SETTINGS_FOLDERS_ID,
  ] as const) privateProPortableAppSettingsReset(group);
}
