import {injectable} from '@loopback/core';
import {TOOL_NAME, TOOL_TAG} from '../constant';

export function graphTool(): ClassDecorator {
  return function <T extends Function>(target: T) {
    injectable({
      tags: {
        [TOOL_NAME]: target.name,
        [TOOL_TAG]: true,
      },
    })(target);
  };
}
