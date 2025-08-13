import {injectable} from '@loopback/core';
import {GRAPH_NODE_NAME, GRAPH_NODE_TAG} from '../constant';

export function graphNode(key: string): ClassDecorator {
  return function <T extends Function>(target: T) {
    injectable({
      tags: {
        [GRAPH_NODE_NAME]: key,
        [GRAPH_NODE_TAG]: true,
      },
    })(target);
  };
}
