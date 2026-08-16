import * as React from 'react';
import { Avatar, Button, Divider, IconButton, Stack, Tooltip, Typography } from '@mui/joy';
import AccountCircleRoundedIcon from '@mui/icons-material/AccountCircleRounded';

import { GoodModal } from '~/common/components/modals/GoodModal';

import { privateProClientConfig } from '../config/privatePro.config';
import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { PrivateProSyncStatus } from './PrivateProSyncStatus';
import { PrivateProVaultResetDialog } from './PrivateProVaultResetDialog';


export function PrivateProAccountControl(props: { mobile?: boolean }) {
  const { user, signOut } = usePrivateProAuth();
  const [open, setOpen] = React.useState(false);
  const [resetShown, setResetShown] = React.useState(false);

  if (!privateProClientConfig.enabled || !user) return null;

  return <>
    <Tooltip title='Private Pro account'>
      <IconButton variant='plain' color='neutral' onClick={() => setOpen(true)} sx={props.mobile ? undefined : { borderRadius: '50%' }}>
        {user.photoURL ? <Avatar size='sm' src={user.photoURL} alt='' /> : <AccountCircleRoundedIcon />}
      </IconButton>
    </Tooltip>
    <GoodModal open={open} onClose={() => setOpen(false)} title='Private Pro' strongerTitle>
      <Stack spacing={2} sx={{ minWidth: { sm: 360 } }}>
        <Stack direction='row' spacing={1.5} alignItems='center'>
          <Avatar src={user.photoURL ?? undefined}>{user.displayName?.slice(0, 1)}</Avatar>
          <div>
            <Typography level='title-md'>{user.displayName || 'Google account'}</Typography>
            <Typography level='body-sm' textColor='text.secondary'>{user.email}</Typography>
          </div>
        </Stack>
        <Divider />
        <PrivateProSyncStatus />
        <Divider />
        {resetShown
          ? <PrivateProVaultResetDialog onDone={() => setResetShown(false)} />
          : <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
            <Button variant='soft' color='neutral' onClick={() => void signOut()}>Sign out</Button>
            <Button variant='plain' color='danger' onClick={() => setResetShown(true)}>Reset local vault</Button>
          </Stack>}
      </Stack>
    </GoodModal>
  </>;
}
