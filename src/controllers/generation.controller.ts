import {service} from '@loopback/core';
import {post} from '@loopback/rest';
import {OPERATION_SECURITY_SPEC} from '@sourceloop/core';
import {multipartRequestBody} from '@sourceloop/file-utils';
import {authenticate, STRATEGY} from 'loopback4-authentication';
import {authorize} from 'loopback4-authorization';
import {UserRequestDto} from '../models/user-request-dto.model';
import {PermissionKey} from '../permissions';
import {GenerationService} from '../services';

export class GenerationController {
  constructor(
    @service(GenerationService)
    private readonly generationService: GenerationService,
  ) {}
  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @authorize({permissions: [PermissionKey.AskAI]})
  @post('/reply', {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      '200': {
        description: 'Generation Response',
        content: {},
      },
    },
  })
  async generate(
    @multipartRequestBody(UserRequestDto)
    data: UserRequestDto,
  ) {
    return this.generationService.generate(
      data.prompt,
      data.files,
      data.sessionId,
    );
  }
}
