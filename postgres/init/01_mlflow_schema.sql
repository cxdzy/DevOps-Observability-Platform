-- MLflow Backend — PostgreSQL Relational Database
-- Stores ML experiment metadata, model versions, and evaluation metrics

CREATE SCHEMA IF NOT EXISTS mlflow;

CREATE TABLE mlflow.experiment (
    experiment_id    SERIAL PRIMARY KEY,
    name              VARCHAR(200) NOT NULL UNIQUE,
    artifact_location VARCHAR(500),
    lifecycle_stage   VARCHAR(20) NOT NULL DEFAULT 'active',
    creation_time     BIGINT NOT NULL
);

CREATE TABLE mlflow.run (
    run_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    experiment_id   INTEGER NOT NULL REFERENCES mlflow.experiment(experiment_id),
    status          VARCHAR(20) NOT NULL,
    start_time      BIGINT NOT NULL,
    end_time        BIGINT,
    user_id         VARCHAR(100)
);

CREATE TABLE mlflow.metric (
    metric_id     SERIAL PRIMARY KEY,
    run_id        UUID NOT NULL REFERENCES mlflow.run(run_id),
    key           VARCHAR(100) NOT NULL,
    value         DOUBLE PRECISION NOT NULL,
    step          INTEGER NOT NULL DEFAULT 0,
    timestamp_id  BIGINT NOT NULL
);

CREATE TABLE mlflow.param (
    param_id      SERIAL PRIMARY KEY,
    run_id        UUID NOT NULL REFERENCES mlflow.run(run_id),
    key           VARCHAR(100) NOT NULL,
    value         VARCHAR(500) NOT NULL,
    description   VARCHAR(500)
);

CREATE INDEX idx_run_experiment ON mlflow.run(experiment_id);
CREATE INDEX idx_metric_run ON mlflow.metric(run_id);
CREATE INDEX idx_param_run ON mlflow.param(run_id);

-- Seed data: two experiments comparing Isolation Forest against One-Class SVM

INSERT INTO mlflow.experiment (name, artifact_location, lifecycle_stage, creation_time) VALUES
('isolation-forest-baseline', '/mlflow/artifacts/1', 'active', 1758067200000),
('one-class-svm-comparison',  '/mlflow/artifacts/2', 'active', 1758153600000);

INSERT INTO mlflow.run (run_id, experiment_id, status, start_time, end_time, user_id) VALUES
('a1111111-1111-1111-1111-111111111111', 1, 'FINISHED', 1758067260000, 1758067860000, 'haziq'),
('a2222222-2222-2222-2222-222222222222', 1, 'FINISHED', 1758153660000, 1758154260000, 'haziq'),
('b1111111-1111-1111-1111-111111111111', 2, 'FINISHED', 1758240060000, 1758240900000, 'haziq'),
('b2222222-2222-2222-2222-222222222222', 2, 'FAILED',   1758326460000, 1758326520000, 'haziq');

INSERT INTO mlflow.metric (run_id, key, value, step, timestamp_id) VALUES
('a1111111-1111-1111-1111-111111111111', 'precision', 0.94, 0, 1758067860000),
('a1111111-1111-1111-1111-111111111111', 'recall',    0.91, 0, 1758067860000),
('a1111111-1111-1111-1111-111111111111', 'f1_score',  0.925, 0, 1758067860000),
('a2222222-2222-2222-2222-222222222222', 'precision', 0.96, 0, 1758154260000),
('a2222222-2222-2222-2222-222222222222', 'recall',    0.93, 0, 1758154260000),
('a2222222-2222-2222-2222-222222222222', 'f1_score',  0.945, 0, 1758154260000),
('b1111111-1111-1111-1111-111111111111', 'precision', 0.88, 0, 1758240900000),
('b1111111-1111-1111-1111-111111111111', 'recall',    0.85, 0, 1758240900000),
('b1111111-1111-1111-1111-111111111111', 'f1_score',  0.865, 0, 1758240900000);

INSERT INTO mlflow.param (run_id, key, value, description) VALUES
('a1111111-1111-1111-1111-111111111111', 'contamination', '0.05', 'Expected proportion of anomalies'),
('a1111111-1111-1111-1111-111111111111', 'n_estimators', '100', 'Number of isolation trees'),
('a2222222-2222-2222-2222-222222222222', 'contamination', '0.03', 'Expected proportion of anomalies'),
('a2222222-2222-2222-2222-222222222222', 'n_estimators', '150', 'Number of isolation trees'),
('b1111111-1111-1111-1111-111111111111', 'kernel', 'rbf', 'SVM kernel function'),
('b1111111-1111-1111-1111-111111111111', 'nu', '0.05', 'Upper bound on training error fraction');
