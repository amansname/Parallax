// Projection Engine implementation; public consumers import engine.js.


export const PROJECTION_EXECUTION_LIMITS = Object.freeze({
  maxIterations: 1000,
  maxHorizonYears: 126,
});

function projectionRangeError(code, message){
  const error = new RangeError(message);
  error.code = code;
  return error;
}

export function validateProjectionHorizon(horizonYears, label = 'projection horizon'){
  if(!Number.isInteger(horizonYears)
      || horizonYears < 1
      || horizonYears > PROJECTION_EXECUTION_LIMITS.maxHorizonYears){
    throw projectionRangeError(
      'PROJECTION_HORIZON_OUT_OF_RANGE',
      `${label} must be an integer between 1 and ${PROJECTION_EXECUTION_LIMITS.maxHorizonYears} years`,
    );
  }
  return horizonYears;
}

export function validateProjectionIterations(iterations){
  if(!Number.isInteger(iterations)
      || iterations < 1
      || iterations > PROJECTION_EXECUTION_LIMITS.maxIterations){
    throw projectionRangeError(
      'PROJECTION_ITERATIONS_OUT_OF_RANGE',
      `simulation iterations must be an integer between 1 and ${PROJECTION_EXECUTION_LIMITS.maxIterations}`,
    );
  }
  return iterations;
}

export function validateReturnPaths(returnPaths, horizonYears){
  if(!Array.isArray(returnPaths)){
    throw projectionRangeError(
      'PROJECTION_RETURN_PATH_DIMENSIONS_INVALID',
      'returnPaths must be an array when supplied',
    );
  }
  validateProjectionIterations(returnPaths.length);
  returnPaths.forEach((path, index) => {
    if(!Array.isArray(path)
        || path.length < horizonYears
        || path.length > PROJECTION_EXECUTION_LIMITS.maxHorizonYears){
      throw projectionRangeError(
        'PROJECTION_RETURN_PATH_DIMENSIONS_INVALID',
        `returnPaths[${index}] must contain between ${horizonYears} and ${PROJECTION_EXECUTION_LIMITS.maxHorizonYears} years`,
      );
    }
  });
}
