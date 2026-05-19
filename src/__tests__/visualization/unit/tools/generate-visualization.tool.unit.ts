import {expect} from '@loopback/testlab';
import {
  formatGenerateVisualizationResult,
  getGenerateVisualizationMetadata,
} from '../../../../mastra/workflows/visualization/tools/generate-visualization.tool';

describe('GenerateVisualizationTool Unit', function () {
  it('formats successful visualization output message', () => {
    const formatted = formatGenerateVisualizationResult({
      status: 'completed',
      done: true,
      datasetId: 'dataset-1',
      visualizerName: 'bar',
      visualizerConfig: {
        categoryColumn: 'month',
        valueColumn: 'revenue',
      },
      replyToUser:
        'Visualization rendered for the user with the following config: {}',
    });

    expect(formatted).to.equal(
      'Visualization rendered for the user with the following config: {}',
    );
  });

  it('formats failed visualization output message', () => {
    const formatted = formatGenerateVisualizationResult({
      status: 'failed',
      done: false,
      error: 'No suitable visualization found',
      replyToUser:
        'Visualization could not be generated. Reason: No suitable visualization found',
    });

    expect(formatted).to.equal(
      'Visualization could not be generated. Reason: No suitable visualization found',
    );
  });

  it('extracts metadata with visualization payload', () => {
    const metadata = getGenerateVisualizationMetadata({
      status: 'completed',
      done: true,
      datasetId: 'dataset-42',
      visualizerName: 'line',
      visualizerConfig: {
        xAxisColumn: 'month',
        yAxisColumn: 'sales',
      },
      replyToUser: 'ok',
    });

    expect(metadata).to.deepEqual({
      status: 'completed',
      existingDatasetId: 'dataset-42',
      config: {
        xAxisColumn: 'month',
        yAxisColumn: 'sales',
      },
      visualization: 'line',
    });
  });
});
