import {injectable} from '@loopback/core';
import {VISUALIZATION_KEY} from '../keys';

export function visualizer(): ClassDecorator {
  return function <T extends Function>(target: T) {
    injectable({
      tags: {
        [VISUALIZATION_KEY]: true,
      },
    })(target);
  };
}
