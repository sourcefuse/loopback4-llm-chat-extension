export interface ILimitStrategy {
  check(): Promise<void>;
}
