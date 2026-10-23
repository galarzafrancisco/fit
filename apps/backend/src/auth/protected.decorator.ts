import { UseGuards, applyDecorators } from '@nestjs/common';
import { AccessTokenGuard } from '@taico/auth/nest';
import { FitUserGuard } from './user.guard';

/** Requires a valid Taico access token for this resource and resolves the Fit user */
export const Protected = () => applyDecorators(UseGuards(AccessTokenGuard, FitUserGuard));
