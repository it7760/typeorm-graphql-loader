import { Author, Book, Publisher, Review } from "./entity";
import resolvers from "./resolvers";
import { Connection, createConnection } from "typeorm";
import { Seeder } from "./Seeder";
import { GraphQLDatabaseLoader } from "../GraphQLDatabaseLoader";
import { LoaderOptions } from "../types";
import { buildSchema } from "type-graphql";
import { GraphQLSchema } from "graphql";

export interface TestHelpers {
  schema: GraphQLSchema;
  loader: GraphQLDatabaseLoader;
  connection: Connection;
}

export async function startup(
  testName: string,
  loaderOptions?: LoaderOptions
): Promise<TestHelpers> {
  const connection = await createConnection({
    name: testName,
    type: "sqlite",
    database: `test_${testName}.sqlite3`,
    synchronize: true,
    dropSchema: true,
    entities: [Author, Book, Publisher, Review],
    logging: false
  });

  const seeder = new Seeder(connection);
  await seeder.seed();

  const loader = new GraphQLDatabaseLoader(connection, loaderOptions);
  const schema = await buildSchema({ resolvers });

  return { schema, loader, connection };
}
