import {Entity, model, property} from '@loopback/repository';

@model({
  name: 'exchange_rates',
  settings: {
    description: 'Model representing exchange rates to USD in the system.',
  },
})
export class ExchangeRate extends Entity {
  @property({
    type: 'string',
    id: true,
    description: 'Unique identifier for the exchange rate record',
  })
  id?: string;

  @property({
    type: 'string',
    required: true,
    name: 'currency_id',
    description:
      'The ID of the currency for which this exchange rate is applicable.',
  })
  currencyId: string;

  @property({
    type: 'number',
    required: true,
    description:
      'The exchange rate to USD for the specified currency, divide by this value to convert to USD value.',
  })
  rate: number;

  @property({
    type: 'string',
    required: true,
    name: 'start_date',
    description:
      'For what period is this exchange rate applicable. This is the start date of the period.',
  })
  startDate: string;

  @property({
    type: 'string',
    name: 'end_date',
    description:
      'For what period is this exchange rate applicable. This is the end date of the period. If this is null, it means the rate is currently applicable.',
  })
  endDate?: string;

  constructor(data?: Partial<ExchangeRate>) {
    super(data);
  }
}
