import {inject} from '@loopback/core';
import {AnyObject, repository} from '@loopback/repository';
import {ILogger, LOGGER} from '@sourceloop/core';
import {ICache} from '../../../types';
import {RedisCacheRepository} from './redis-cache.repository';

export class RedisCache implements ICache {
  constructor(
    @repository(RedisCacheRepository)
    private readonly cacheRepository: RedisCacheRepository,
    @inject(LOGGER.LOGGER_INJECT)
    private readonly logger: ILogger,
  ) {}

  async set<T = AnyObject>(key: string, value: T): Promise<void> {
    const cacheModel = {
      key,
      value: JSON.stringify(value),
    };
    await this.cacheRepository.set(key, cacheModel);
  }

  async get<T = AnyObject>(key: string): Promise<T | null> {
    const cacheModel = await this.cacheRepository.get(key);
    if (!cacheModel) {
      return null;
    }
    try {
      return JSON.parse(cacheModel.value);
    } catch (error) {
      this.logger.error(`Error parsing cache value for key ${key}:`, error);
      return null;
    }
  }
}
