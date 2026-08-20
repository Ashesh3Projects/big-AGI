import { Alert, Box, Button, CircularProgress, Sheet, Typography } from '@mui/joy';

import { AuthGoogleIcon } from '~/common/components/icons/3rdparty/AuthGoogleIcon';


export function PrivateProAuthScreen(props: {
  state: 'loading' | 'signed-out' | 'bootstrapping' | 'denied' | 'misconfigured' | 'error';
  error?: string;
  deniedEmail?: string;
  onSignIn: () => void;
}) {
  const busy = props.state === 'loading' || props.state === 'bootstrapping';
  const title = props.state === 'denied' ? 'Access denied'
    : props.state === 'misconfigured' ? 'Private Pro is not configured'
      : props.state === 'error' ? 'Sign-in failed'
        : 'Private Pro';

  return (
    <Sheet sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', p: 2 }}>
      <Box sx={{ width: 'min(100%, 420px)', display: 'grid', gap: 2, textAlign: 'center' }}>
        <Typography level='h2'>{title}</Typography>
        {busy && <CircularProgress sx={{ mx: 'auto' }} />}
        {props.state === 'signed-out' && <>
          <Typography textColor='text.secondary'>Sign in with an approved Google account.</Typography>
          <Button startDecorator={<AuthGoogleIcon />} onClick={props.onSignIn}>Continue with Google</Button>
        </>}
        {props.state === 'bootstrapping' && <Typography textColor='text.secondary'>Preparing your private workspace...</Typography>}
        {props.state === 'denied' && <>
          <Alert color='danger'>The account {props.deniedEmail || 'you selected'} is not on the allowlist for this deployment.</Alert>
          <Button startDecorator={<AuthGoogleIcon />} onClick={props.onSignIn}>Try another Google account</Button>
        </>}
        {props.state === 'misconfigured' && <Alert color='warning'>{props.error}</Alert>}
        {props.state === 'error' && <>
          <Alert color='danger'>{props.error || 'Unable to complete Google sign-in.'}</Alert>
          <Button startDecorator={<AuthGoogleIcon />} onClick={props.onSignIn}>Try another Google account</Button>
        </>}
      </Box>
    </Sheet>
  );
}
