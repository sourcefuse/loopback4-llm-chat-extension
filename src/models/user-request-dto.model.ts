import {Entity, model, property} from '@loopback/repository';
import {fileProperty} from '@sourceloop/file-utils';

@model({
  settings: {
    multer: {
      limitsProvider: true,
    },
  },
})
export class UserRequestDto extends Entity {
  @property({
    type: 'string',
    required: true,
  })
  prompt: string;

  // file field
  @fileProperty({
    type: 'object',
    // you can configure individual fields here
    validators: [],
    extensions: ['.pdf'],
  })
  files: Express.Multer.File[];

  @property({
    type: 'string',
    required: true,
  })
  sessionId?: string;

  constructor(data?: Partial<UserRequestDto>) {
    super(data);
  }
}
