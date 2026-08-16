import * as React from 'react';
import { Alert, Button, FormControl, FormLabel, Input, Stack, Typography } from '@mui/joy';

import { personaSyncResetAll } from '../../../apps/personas/store-app-personas';
import { chatSyncResetAll } from '~/common/stores/chat/store-chats';
import { gcDBAssetsByScope } from '~/common/stores/blob/dblobs-portability';

import { privateProSyncDB } from '../sync/privatePro.sync.db';
import { usePrivateProAuth } from '../auth/ProviderPrivatePro';


const CONFIRMATION = 'RESET LOCAL VAULT';

export function PrivateProVaultResetDialog(props: { onDone: () => void }) {
  const { signOut } = usePrivateProAuth();
  const [confirmation, setConfirmation] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const reset = async () => {
    setBusy(true);
    try {
      chatSyncResetAll();
      personaSyncResetAll();
      await gcDBAssetsByScope('global', 'app-chat', null, []);
      await privateProSyncDB.resetVaultBinding();
      await signOut();
      props.onDone();
      window.location.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Stack spacing={1.5}>
      <Alert color='danger'>Export a full backup first. This removes local synchronized chats, personas, and attachments. Model settings and API keys stay on this device.</Alert>
      <Typography level='body-sm'>Type <strong>{CONFIRMATION}</strong> to continue.</Typography>
      <FormControl>
        <FormLabel>Confirmation</FormLabel>
        <Input value={confirmation} onChange={event => setConfirmation(event.target.value)} />
      </FormControl>
      <Button color='danger' loading={busy} disabled={confirmation !== CONFIRMATION} onClick={() => void reset()}>
        Reset local vault
      </Button>
    </Stack>
  );
}
