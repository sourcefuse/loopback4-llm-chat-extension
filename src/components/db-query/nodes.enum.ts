export enum DbQueryNodes {
  GetTables = 'get_tables',
  GetColumns = 'get_columns',
  CheckPermissions = 'check_permissions',
  SqlGeneration = 'sql_generation',
  SyntacticValidator = 'syntactic_validator',
  SemanticValidator = 'semantic_validator',
  IsImprovement = 'is_improvement',
  Failed = 'failed',
  SaveDataset = 'save_dataset',
  CheckCache = 'check_cache',
}
