import {IDbConnector, QueryParam} from '../../types';
import {PgConnector} from './pg.connector';

export class PgWithRlsConnector extends PgConnector implements IDbConnector {
  protected override async _execute(query: string, params?: QueryParam[]) {
    const conditions = this.defaultConditions
      ? Object.entries(this.defaultConditions)
      : [];
    const tx = await this.db.beginTransaction({});
    try {
      await Promise.all(
        conditions.map(([key, value]) => [
          this.db.execute(
            `SELECT set_config('app.${key}', $1, true);`,
            [value],
            {
              transaction: tx,
            },
          ),
        ]),
      );

      const result = await this.db.execute(query, params, {transaction: tx});
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
}
