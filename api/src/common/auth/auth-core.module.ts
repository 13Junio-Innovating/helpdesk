import { Global, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AppConfig } from '../../config/app-config.js';
import { MembershipService } from './membership.service.js';
import { JWT_AUDIENCE, JWT_ISSUER, TokensService } from './tokens.service.js';

@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [AppConfig],
      useFactory: (config: AppConfig) => ({
        secret: config.get('JWT_SECRET'),
        signOptions: { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
        verifyOptions: { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
      }),
    }),
  ],
  providers: [TokensService, MembershipService],
  exports: [TokensService, MembershipService],
})
export class AuthCoreModule {}
