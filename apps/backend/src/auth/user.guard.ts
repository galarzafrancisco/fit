import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { authContextOf } from '@taico/auth/nest';
import { UsersService, type CurrentUser } from '../users/users.service';

type RequestWithUser = { fitUser?: CurrentUser };

/**
 * Runs after AccessTokenGuard: maps the validated token to a Fit user and
 * puts it on the request. Handlers take the user only from here.
 */
@Injectable()
export class FitUserGuard implements CanActivate {
  constructor(private readonly users: UsersService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const auth = authContextOf(context);
    if (!auth) return false;
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    request.fitUser = await this.users.resolve(auth);
    return true;
  }
}

export const AuthenticatedUser = createParamDecorator((_data: unknown, context: ExecutionContext): CurrentUser => {
  const user = context.switchToHttp().getRequest<RequestWithUser>().fitUser;
  if (!user) throw new Error('FitUserGuard did not run on this route');
  return user;
});
