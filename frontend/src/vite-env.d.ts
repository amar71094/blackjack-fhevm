/// <reference types="vite/client" />

// Static asset modules
declare module "*.jpg" {
	const src: string;
	export default src;
}
declare module "*.jpeg" {
	const src: string;
	export default src;
}
declare module "*.png" {
	const src: string;
	export default src;
}
declare module "*.svg" {
	const src: string;
	export default src;
}

interface ImportMetaEnv {
	readonly VITE_BLACKJACK_CONTRACT?: `0x${string}`;
	readonly VITE_FHE_TARGET_CHAIN_ID?: string;
	readonly VITE_FHE_GATEWAY_CHAIN_ID?: string;
	readonly VITE_FHE_RPC_URL?: string;
	readonly VITE_FHE_RELAYER_URL?: string;
	readonly VITE_FHE_ACL_ADDRESS?: `0x${string}`;
	readonly VITE_FHE_KMS_ADDRESS?: `0x${string}`;
	readonly VITE_FHE_INPUT_VERIFIER_ADDRESS?: `0x${string}`;
	readonly VITE_FHE_DECRYPTION_ORACLE_ADDRESS?: `0x${string}`;
	readonly VITE_FHE_INPUT_VERIFICATION_ADDRESS?: `0x${string}`;
	readonly VITE_ORACLE_ACTIVITY_URL?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
