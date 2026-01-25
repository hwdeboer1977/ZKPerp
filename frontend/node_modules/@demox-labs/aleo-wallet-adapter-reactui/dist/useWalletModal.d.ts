export interface WalletModalContextState {
    visible: boolean;
    setVisible: (open: boolean) => void;
}
export declare const WalletModalContext: any;
export declare function useWalletModal(): WalletModalContextState;
