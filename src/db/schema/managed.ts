/**
 * drizzle-kit entry point: every table EXCEPT the partitioned detail tables
 * (see partitioned.ts — those are created by hand-written migration SQL).
 */
export * from './partners';
export * from './users';
export * from './api-keys';
export * from './orders';
export * from './fleet-gojek';
export * from './fleet-grab';
export * from './partner-plates';
export * from './checkpoints';
export * from './rentals';

export * from './activity-log';
export * from './drivers';
export * from './deposit-installments';
