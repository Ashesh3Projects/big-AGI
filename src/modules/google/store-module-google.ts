import { create } from 'zustand';
import { persist } from 'zustand/middleware';


interface ModuleGoogleSearchStore {

  // Google Custom Search settings

  googleCloudApiKey: string;
  setGoogleCloudApiKey: (googleApiKey: string) => void;

  googleCSEId: string;
  setGoogleCSEId: (cseId: string) => void;

  restrictToDomain: string;
  setRestrictToDomain: (domain: string) => void;

}

export const useGoogleSearchStore = create<ModuleGoogleSearchStore>()(
  persist(
    (set) => ({

      // Google Custom Search settings

      googleCloudApiKey: '',
      setGoogleCloudApiKey: (googleApiKey: string) => set({ googleCloudApiKey: googleApiKey }),

      googleCSEId: '',
      setGoogleCSEId: (cseId: string) => set({ googleCSEId: cseId }),

      restrictToDomain: '',
      setRestrictToDomain: (domain: string) => set({ restrictToDomain: domain }),

    }),
    {
      name: 'app-module-google-search',
    }),
);


/// Private vault adapters

export interface GoogleVaultState {
  googleCloudApiKey: string;
  googleCSEId: string;
  restrictToDomain: string;
}

export function googleVaultSnapshot(): GoogleVaultState {
  const { googleCloudApiKey, googleCSEId, restrictToDomain } = useGoogleSearchStore.getState();
  return { googleCloudApiKey, googleCSEId, restrictToDomain };
}

export function googleVaultApply(value: GoogleVaultState): void {
  useGoogleSearchStore.setState(structuredClone(value));
}

export function googleVaultReset(): void {
  useGoogleSearchStore.setState({ googleCloudApiKey: '', googleCSEId: '', restrictToDomain: '' });
}

export function googleVaultSubscribe(listener: () => void): () => void {
  return useGoogleSearchStore.subscribe(listener);
}
