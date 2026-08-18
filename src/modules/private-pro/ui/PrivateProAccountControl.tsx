import * as React from 'react';
import { fileOpen } from 'browser-fs-access';
import { Alert, Avatar, Button, Divider, FormControl, FormLabel, IconButton, Input, Stack, Tab, TabList, TabPanel, Tabs, Tooltip, Typography } from '@mui/joy';
import AccountCircleRoundedIcon from '@mui/icons-material/AccountCircleRounded';

import { GoodModal } from '~/common/components/modals/GoodModal';

import { privateProClientConfig } from '../config/privatePro.config';
import { usePrivateProAuth } from '../auth/ProviderPrivatePro';
import { privateProVaultPasswordStrength, usePrivateProVault } from '../vault/ProviderPrivateProVault';


export function PrivateProAccountControl(props: { mobile?: boolean }) {
  const { user } = usePrivateProAuth();
  const vault = usePrivateProVault();
  const [open, setOpen] = React.useState(false);
  const [action, setAction] = React.useState<'password' | 'import' | 'wipe' | null>(null);
  const [currentPassword, setCurrentPassword] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [passwordConfirmation, setPasswordConfirmation] = React.useState('');
  const [message, setMessage] = React.useState<string | null>(null);
  const [importCredential, setImportCredential] = React.useState('');
  const [importKind, setImportKind] = React.useState<'password' | 'recovery'>('password');
  const [busy, setBusy] = React.useState(false);
  const strength = privateProVaultPasswordStrength(password);

  const run = async (operation: () => Promise<void>, success: string) => {
    setBusy(true);
    setMessage(null);
    try {
      await operation();
      setMessage(success);
    } catch {
      setMessage('The encrypted vault action failed.');
    } finally {
      setBusy(false);
    }
  };

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
        <Stack direction='row' justifyContent='space-between' alignItems='center'>
          <Typography level='title-md'>Encrypted vault</Typography>
          <Typography level='body-sm' color={vault.phase === 'ready' ? 'success' : 'warning'}>{vault.phase === 'ready' ? 'Ready' : vault.phase}</Typography>
        </Stack>
        <Divider />
        {message && <Alert color={message.endsWith('failed.') ? 'danger' : 'success'}>{message}</Alert>}
        {vault.revokeOtherDevicesRecommended && <Alert color='warning'>
          Vault credentials changed. Revoke other remembered devices if this was recovery or a security-sensitive password rotation.
          <Button size='sm' color='warning' loading={busy} onClick={() => void run(() => vault.revokeOtherDevices(), 'Other remembered devices revoked.')}>Revoke other devices now</Button>
        </Alert>}
        {action === 'password' ? <Stack spacing={1.5}>
          <FormControl>
            <FormLabel>Current vault password</FormLabel>
            <Input type='password' autoComplete='current-password' value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} />
          </FormControl>
          <FormControl>
            <FormLabel>New vault password</FormLabel>
            <Input type='password' autoComplete='new-password' value={password} onChange={event => setPassword(event.target.value)} />
          </FormControl>
          <FormControl>
            <FormLabel>Confirm new password</FormLabel>
            <Input type='password' autoComplete='new-password' value={passwordConfirmation} onChange={event => setPasswordConfirmation(event.target.value)} />
          </FormControl>
          <Stack direction='row' spacing={1}>
            <Button
              loading={busy}
              disabled={!currentPassword || !strength.acceptable || password !== passwordConfirmation}
              onClick={() => void run(async () => {
                await vault.changePassword(currentPassword, password);
                setCurrentPassword('');
                setPassword('');
                setPasswordConfirmation('');
                setAction(null);
              }, 'Vault password changed.')}
            >
              Change password
            </Button>
            <Button variant='plain' color='neutral' onClick={() => setAction(null)}>Cancel</Button>
          </Stack>
        </Stack> : <Stack spacing={1}>
            <Button variant='soft' color='neutral' onClick={() => setAction('password')}>Change vault password</Button>
            <Button variant='soft' color='neutral' loading={busy} onClick={() => void run(() => vault.createEncryptedExport(), 'Encrypted backup saved.')}>Create encrypted backup</Button>
            <Button variant='soft' color='neutral' onClick={() => setAction('import')}>Merge encrypted backup</Button>
            <Button variant='soft' color='neutral' loading={busy} onClick={() => void run(() => vault.revokeOtherDevices(), 'Other remembered devices revoked.')}>Revoke other devices</Button>
            <Button variant='soft' color='neutral' onClick={() => void vault.logout()}>Sign out</Button>
            <Button variant='plain' color='danger' onClick={() => setAction('wipe')}>Full local wipe</Button>
            {action === 'wipe' && <Alert color='danger'>Full local wipe removes this browser&apos;s encrypted cache and remembered key. Use account recovery to unlock again.</Alert>}
            {action === 'wipe' && <Button color='danger' loading={busy} onClick={() => void vault.fullLocalWipe()}>Confirm full local wipe</Button>}
            {action === 'import' && <Stack spacing={1.5}>
              <Alert color='warning'>Merge adds or updates backup records in the cloud vault. Existing cloud-only records are kept.</Alert>
              <Tabs value={importKind} onChange={(_event, value) => value && setImportKind(value as 'password' | 'recovery')}>
                <TabList><Tab value='password'>Password</Tab><Tab value='recovery'>Recovery key</Tab></TabList>
                <TabPanel value='password' sx={{ px: 0 }} />
                <TabPanel value='recovery' sx={{ px: 0 }} />
              </Tabs>
              <Input
                type={importKind === 'password' ? 'password' : 'text'}
                aria-label={importKind === 'password' ? 'Backup vault password' : 'Backup recovery key'}
                value={importCredential}
                onChange={event => setImportCredential(event.target.value)}
              />
              <Button loading={busy} disabled={!importCredential} onClick={() => void run(async () => {
                const file = await fileOpen({ extensions: ['.ndjson'], description: 'Private Pro encrypted backup', mimeTypes: ['application/x-ndjson'] });
                await vault.importEncryptedBackup(file.stream(), importKind === 'password'
                  ? { kind: 'password', password: importCredential }
                  : { kind: 'recovery', recoveryKey: importCredential });
              }, 'Encrypted backup merged into the cloud vault.')}>Merge encrypted backup</Button>
            </Stack>}
          </Stack>}
      </Stack>
    </GoodModal>
  </>;
}
