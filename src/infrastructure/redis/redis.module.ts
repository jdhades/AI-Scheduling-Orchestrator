import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Module({
    providers: [
        {
            provide: 'REDIS_CLIENT',
            inject: [ConfigService],
            useFactory: (configService: ConfigService) => {
                return new Redis({
                    host: configService.get<string>('redis.host'),
                    port: configService.get<number>('redis.port'),
                });
            },
        },
    ],
    exports: ['REDIS_CLIENT'],
})
export class RedisModule { }