import { Inject, Injectable } from '@nestjs/common';
import { Connection } from 'amqplib';
import bunyan from 'bunyan';
import { plainToClass } from 'class-transformer';
import { validate } from 'class-validator';
import { InjectAmqpConnection } from 'nestjs-amqp';
import { getManager } from 'typeorm';
import { CoinEnum } from '../coins';
import { Account } from '../entities/account.entity';
import { Deposit } from '../entities/deposit.entity';
import { Withdrawal } from '../entities/withdrawal.entity';
import { CreateWithdrawalDto } from './create-withdrawal.dto';

@Injectable()
export class AmqpService {
  private readonly logger: bunyan;
  private readonly connection: Connection;
  private readonly coinServices: { [_ in CoinEnum]?: ICoinService };

  constructor(
    logger: bunyan,
    @InjectAmqpConnection() connection: Connection,
    @Inject('CoinServiceRepo') coinServices: { [_ in CoinEnum]?: ICoinService },
  ) {
    this.logger = logger;
    this.connection = connection;
    this.coinServices = coinServices;
    this.assertQueues();
    this.createWithdrawal();
  }

  public async updateWithdrawal(withdrawal: Withdrawal): Promise<void> {
    await this.publish('withdrawal_update', withdrawal);
  }

  public async createDeposit(deposit: Deposit): Promise<void> {
    await this.publish('deposit_creation', deposit);
  }

  public async updateDeposit(deposit: Deposit): Promise<void> {
    await this.publish('deposit_update', deposit);
  }

  private async publish(queue: string, message: any): Promise<void> {
    const channel = await this.connection.createChannel();
    await channel.assertQueue(queue);
    channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)));
  }

  private async assertQueues(): Promise<void> {
    const channel = await this.connection.createChannel();
    await Promise.all([
      channel.assertQueue('deposit_creation'),
      channel.assertQueue('deposit_update'),
      channel.assertQueue('withdrawal_update'),
    ]);
  }

  private async createWithdrawal(): Promise<void> {
    const channel = await this.connection.createChannel();
    const queue = 'withdrawal_creation';
    await channel.assertQueue(queue);
    channel.consume(queue, async (msg) => {
      if (!msg) {
        return;
      }
      const body = plainToClass(CreateWithdrawalDto, JSON.parse(
        msg.content.toString(),
      ) as object);
      validate(body);
      const clientId = 0;
      if (
        await Withdrawal.findOne({
          clientId,
          key: body.key,
        })
      ) {
        channel.ack(msg);
        return;
      }
      const coinService = this.coinServices[body.coinSymbol];
      if (!coinService) {
        channel.ack(msg);
        return;
      }
      if (!coinService.isValidAddress(body.recipient)) {
        this.logger.info(
          `invalid address from client #${clientId}: ${JSON.stringify(body)}`,
        );
        channel.ack(msg);
        return;
      }
      await Account.createQueryBuilder()
        .insert()
        .values({ clientId, coinSymbol: body.coinSymbol })
        .onConflict('("clientId", "coinSymbol") DO NOTHING')
        .execute();
      await getManager().transaction(async (manager) => {
        const account = await manager
          .createQueryBuilder(Account, 'account')
          .where({ clientId, coinSymbol: body.coinSymbol })
          .setLock('pessimistic_write')
          .getOne();
        if (!account) {
          channel.ack(msg);
          return;
        }
        await manager.decrement(
          Account,
          { clientId, coinSymbol: body.coinSymbol },
          'balance',
          Number(body.amount),
        );
        await manager
          .createQueryBuilder()
          .insert()
          .into(Withdrawal)
          .values({
            amount: body.amount,
            clientId,
            coinSymbol: body.coinSymbol,
            key: body.key,
            memo: body.memo,
            recipient: body.recipient,
          })
          .execute();
      });
      channel.ack(msg);
    });
  }
}
