/**
 * Guest-like values deliberately planted in EVERY mock Smoobu response.
 * The privacy test asserts that none of them ever appears in a tool result.
 */
export const POISON = {
  guestFirstName: 'Mariana',
  guestLastName: 'Poisonwood',
  guestFullName: 'Mariana Poisonwood',
  email: 'mariana.poisonwood@example.com',
  phone: '+506 8888-7777',
  phoneDigits: '50688887777',
  reservationId: 55667788,
  reservationRef: 'RES-55667788',
  channelName: 'Airbnb',
  channelId: 6382917,
  internalApartmentName: 'INTERNAL Unit 7 - Smoobu label',
  blockReason: 'Owner stay - do not rent',
  notice: 'Guest arrives late, breakfast for two, one dog',
  address: 'Calle Falsa 123, Puerto Viejo',
  customerId: 424242,
  apiKeyEcho: 'usr_live_SHOULD_NEVER_LEAK',
} as const;

export const POISON_VALUES: readonly string[] = Object.values(POISON).map(String);
