import {ModelDefaultSettings} from '../../../types';

export type BedrockInstanceConfig = {
  model: string;
  config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    defaultSettings?: ModelDefaultSettings;
  };
};
