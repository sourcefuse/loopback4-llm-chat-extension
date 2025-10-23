import {injectable} from '@loopback/core';
import {GRAPH_NODE_NAME, GRAPH_NODE_TAG} from '../constant';
import {AnyObject} from '@loopback/repository';

export function graphNode(
  key: string,
  extraTags: AnyObject = {},
): ClassDecorator {
  return function <T extends Function>(target: T) {
    injectable({
      tags: {
        [GRAPH_NODE_NAME]: key,
        [GRAPH_NODE_TAG]: true,
        ...extraTags,
      },
    })(target);
  };
}
