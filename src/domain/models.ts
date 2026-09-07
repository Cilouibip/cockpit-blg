export type Source = 'meta' | 'notion' | 'wix' | 'posthog' | 'first_party';
export type Tunnel = 'quiz' | 'masterclass';
export type TrafficSource = 'paid' | 'organic' | 'direct' | 'unknown';
export interface Period { from: string; to: string; timezone: string }
export interface Evidence { source: Source; accountId: string; externalId: string; observedAt: string; sourceUpdatedAt?: string; connectorVersion: string; syncRunId?: string }
export interface Coverage { complete: boolean; from: string; to: string; reason?: string; observedAt?: string }
export interface Money { minor: number; currency: string }
export interface LeadRegistration extends Evidence { personId: string | null; tunnel: Tunnel; registeredAt: string; verified: boolean }
export type AppointmentStatus = 'scheduled' | 'attended' | 'no_show' | 'cancelled' | 'rescheduled' | 'unknown';
export interface Appointment extends Evidence { personId: string | null; prospectId?: string; scheduledAt: string; attendedAt?: string; status: AppointmentStatus; sourceStatus: string; rescheduledTo?: string; attendanceEvidence?: string }
export interface Payment extends Evidence { personId: string | null; dealId?: string; kind: 'payment' | 'refund'; originalPaymentId?: string; status: 'settled' | 'pending' | 'failed' | 'cancelled'; effectiveAt: string; amount: Money; installmentId?: string; subscriptionId?: string; taxBasis: 'gross' | 'net' | 'unknown' }
export interface Deal extends Evidence { personId: string | null; signedAt: string | null; amount: Money | null; status: 'signed' | 'cancelled' | 'unknown'; amountEvidence: string | null; taxBasis: 'gross' | 'net' | 'unknown' }
export interface Touchpoint extends Evidence { personId: string | null; occurredAt: string; eventType: 'landing_arrival' | 'page_view' | 'other'; sourceSequence?: number; sourceType: TrafficSource; linkRevisionId: string | null; adId: string | null; campaignId: string | null }
export interface Ratio { value: number | null; numerator: number; denominator: number; reason: string | null }
export interface SourceAggregate extends Evidence { metric: string; from: string; to: string; timezone: string; amount: Money | null; count: number | null; taxBasis: 'gross' | 'net' | 'unknown'; dimensions: Record<string, string>; transactionGrain: false }
