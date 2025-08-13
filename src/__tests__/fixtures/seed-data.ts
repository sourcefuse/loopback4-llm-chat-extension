import {DataObject} from '@loopback/repository';
import {Employee} from './models';
import {Currency} from './models/currency.model';
import {ExchangeRate} from './models/exchange-rate.model';

export const testCurrencies: DataObject<Currency>[] = [
  {
    id: '1',
    name: 'US Dollar',
    code: 'USD',
  },
  {
    id: '3',
    name: 'British Pound',
    code: 'GBP',
  },
  {
    id: '4',
    name: 'Japanese Yen',
    code: 'JPY',
  },
  {
    id: '5',
    name: 'Indian Rupee',
    code: 'INR',
  },
];

export const testEmployees: DataObject<Employee>[] = [
  {
    name: 'John Doe',
    code: 'EMP002',
    salary: 6000,
    currencyId: '1',
    joiningDate: '2025-01-01',
  },
  {
    name: 'Jane Smith',
    code: 'EMP003',
    salary: 7000,
    currencyId: '1',
    joiningDate: '2025-02-01',
  },
  {
    name: 'Dev Patel',
    code: 'EMP004',
    salary: 700497.2, // 7996.543378995434 in USD
    currencyId: '5',
    joiningDate: '2025-03-01',
  },
  {
    name: 'Nameless Gonbei',
    code: 'EMP005',
    salary: 1350603, // 8990.234973041337 in USD
    currencyId: '4',
    joiningDate: '2025-04-01',
  },
  {
    name: 'Charlie White',
    code: 'EMP006',
    salary: 7563.98, // 9952.605263157893 in USD
    currencyId: '3',
    joiningDate: '2025-05-01',
  },
];

export const testExchangeRates: DataObject<ExchangeRate>[] = [
  {
    id: '1',
    currencyId: '1',
    rate: 1,
    startDate: '2023-01-01',
    endDate: undefined,
  },
  {
    id: '2',
    currencyId: '3',
    rate: 0.76,
    startDate: '2024-01-01',
    endDate: undefined,
  },
  {
    id: '3',
    currencyId: '4',
    rate: 150.23,
    startDate: '2024-01-01',
    endDate: undefined,
  },
  {
    id: '4',
    currencyId: '5',
    rate: 87.6,
    startDate: '2024-01-01',
    endDate: undefined,
  },
];
