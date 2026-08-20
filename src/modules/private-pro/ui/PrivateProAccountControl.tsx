import * as React from 'react';
import AccountCircleRoundedIcon from '@mui/icons-material/AccountCircleRounded';
import { Alert, Avatar, Button, IconButton, Stack, Tooltip, Typography } from '@mui/joy';

import { GoodModal } from '~/common/components/modals/GoodModal';

import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { privateProClientConfig } from '../config/privatePro.config';
import { PrivateProUnsyncedChangesError, usePrivateProSync } from '../sync/ProviderPrivateProSync';
import type { PrivateProSyncPhase } from '../sync/store-private-pro-sync';
import { PrivateProSyncStatus } from './PrivateProSyncStatus';


export function PrivateProAccountControlContent(props: {
  email: string;
  phase: PrivateProSyncPhase;
  pending: number;
  busy: boolean;
  confirmDiscard: boolean;
  actionError?: boolean;
  onRetry: () => void;
  onSignOut: () => void;
  onConfirmDiscard: () => void;
  onCancelDiscard: () => void;
}) {
  return (
    <Stack spacing={2} sx={{ minWidth: { sm: 340 } }}>
      <Typography level='body-sm'>{props.email}</Typography>
      <PrivateProSyncStatus phase={props.phase} pending={props.pending} busy={props.busy} onRetry={props.onRetry} />
      {props.actionError && <Alert color='danger'>Unable to complete the account action. Try again.</Alert>}
      {props.confirmDiscard && <Alert color='warning'>Some changes are still pending. Discard them from this browser and sign out?</Alert>}
      {props.confirmDiscard ? (
        <Stack direction='row' spacing={1}>
          <Button color='danger' loading={props.busy} onClick={props.onConfirmDiscard}>Discard and sign out</Button>
          <Button variant='plain' color='neutral' disabled={props.busy} onClick={props.onCancelDiscard}>Cancel</Button>
        </Stack>
      ) : (
        <Button variant='soft' color='neutral' loading={props.busy} onClick={props.onSignOut}>Sign out</Button>
      )}
    </Stack>
  );
}

export function PrivateProAccountControl(props: { mobile?: boolean }) {
  if (!privateProClientConfig.enabled) return null;
  return <PrivateProAccountControlEnabled {...props} />;
}

function PrivateProAccountControlEnabled(props: { mobile?: boolean }) {
  const { user } = usePrivateProAuth();
  const sync = usePrivateProSync();
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);
  const [actionError, setActionError] = React.useState(false);

  if (!user) return null;

  const run = async (discardPending: boolean) => {
    setBusy(true);
    setActionError(false);
    try {
      await sync.signOut(discardPending ? { discardPending: true } : undefined);
    } catch (error) {
      if (error instanceof PrivateProUnsyncedChangesError) setConfirmDiscard(true);
      else setActionError(true);
    } finally {
      setBusy(false);
    }
  };

  return <>
    <Tooltip title='Private Pro account'>
      <IconButton variant='plain' color='neutral' onClick={() => setOpen(true)} sx={props.mobile ? undefined : { borderRadius: '50%' }}>
        {user.photoURL ? <Avatar size='sm' src={user.photoURL} alt='' /> : <AccountCircleRoundedIcon />}
      </IconButton>
    </Tooltip>
    <GoodModal open={open} onClose={() => setOpen(false)} title='Private Pro' strongerTitle>
      <PrivateProAccountControlContent
        email={user.email ?? 'Google account'}
        phase={sync.phase}
        pending={sync.pending}
        busy={busy}
        confirmDiscard={confirmDiscard}
        actionError={actionError}
        onRetry={() => void sync.retry().catch(() => setActionError(true))}
        onSignOut={() => void run(false)}
        onConfirmDiscard={() => void run(true)}
        onCancelDiscard={() => setConfirmDiscard(false)}
      />
    </GoodModal>
  </>;
}
