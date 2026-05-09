import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  constructor(private jwtService: JwtService) {}

  async validateUser(payload: any) {
    // In production, validate against user store
    return payload;
  }

  async login(user: any) {
    return { access_token: this.jwtService.sign({ sub: user.id, roles: user.roles || [] }) };
  }
}
