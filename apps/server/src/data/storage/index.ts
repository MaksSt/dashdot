import getDynamic from './dynamic';
import getStatic from './static';
import getTemperature from './temperature';

export default {
  dynamic: () => getDynamic(),
  static: () => getStatic(),
  temperature: () => getTemperature(),
};
