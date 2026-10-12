export type KycKind = 'gstin' | 'pan' | 'bank' | 'cin';
export type KycStatus = 'VERIFIED' | 'NOT_FOUND' | 'INVALID_FORMAT' | 'ERROR';
export interface KycInput { gstin?: string; pan?: string; accountNumber?: string; ifsc?: string; cin?: string }
export interface KycResult { status: KycStatus; message: string; nameOnRecord?: string; data?: Record<string, string> }
export interface KycProvider { name: string; live: boolean; check(kind: KycKind, input: KycInput, ctx: { legalName: string }): Promise<KycResult> }
