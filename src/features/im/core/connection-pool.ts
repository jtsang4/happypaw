import { logger } from '../../../logger.js';
import type {
  IMChannel,
  IMChannelConnectOpts,
  UserIMConnection,
} from './channel-types.js';

export class IMConnectionPool {
  private readonly connections = new Map<string, UserIMConnection>();

  getOrCreate(userId: string): UserIMConnection {
    let connection = this.connections.get(userId);
    if (!connection) {
      connection = { userId, channels: new Map() };
      this.connections.set(userId, connection);
    }
    return connection;
  }

  get(userId: string): UserIMConnection | undefined {
    return this.connections.get(userId);
  }

  getConnections(): Map<string, UserIMConnection> {
    return this.connections;
  }

  async connectChannel(
    userId: string,
    channelType: string,
    channel: IMChannel,
    opts: IMChannelConnectOpts,
  ): Promise<boolean> {
    await this.disconnectChannel(userId, channelType);

    const connection = this.getOrCreate(userId);
    const connected = await channel.connect(opts);
    if (!connected) return false;

    connection.channels.set(channelType, channel);
    logger.info({ userId, channelType }, 'IM channel connected');
    return true;
  }

  async disconnectChannel(userId: string, channelType: string): Promise<void> {
    const connection = this.connections.get(userId);
    const channel = connection?.channels.get(channelType);
    if (!channel) return;

    await channel.disconnect();
    connection?.channels.delete(channelType);
    logger.info({ userId, channelType }, 'IM channel disconnected');
  }

  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [userId, connection] of this.connections.entries()) {
      for (const [channelType, channel] of connection.channels.entries()) {
        promises.push(
          channel.disconnect().catch((err) => {
            logger.warn(
              { userId, channelType, err },
              'Error stopping IM channel',
            );
          }),
        );
      }
    }

    await Promise.allSettled(promises);
    this.connections.clear();
    logger.info('All IM connections disconnected');
  }

  getConnectedChannelTypes(userId: string): string[] {
    const connection = this.connections.get(userId);
    if (!connection) return [];

    const types: string[] = [];
    for (const [type, channel] of connection.channels.entries()) {
      if (channel.isConnected()) types.push(type);
    }
    return types;
  }

  getConnectedUserIds(): string[] {
    const userIds: string[] = [];
    for (const [userId, connection] of this.connections.entries()) {
      for (const channel of connection.channels.values()) {
        if (!channel.isConnected()) continue;
        userIds.push(userId);
        break;
      }
    }
    return userIds;
  }

  isUserChannelConnected(userId: string, channelType: string): boolean {
    return (
      this.connections.get(userId)?.channels.get(channelType)?.isConnected() ??
      false
    );
  }

  isAnyChannelConnected(channelType: string): boolean {
    for (const connection of this.connections.values()) {
      if (connection.channels.get(channelType)?.isConnected()) return true;
    }
    return false;
  }

  getUserChannel(userId: string, channelType: string): IMChannel | undefined {
    return this.connections.get(userId)?.channels.get(channelType);
  }
}
