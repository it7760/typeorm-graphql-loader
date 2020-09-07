import { Hash, LoaderOptions, Selection } from "./types";
import { LoaderNamingStrategyEnum } from "./enums/LoaderNamingStrategy";
import { Connection, EntityMetadata, SelectQueryBuilder } from "typeorm";
import { Formatter } from "./lib/Formatter";
import { ColumnMetadata } from "typeorm/metadata/ColumnMetadata";
import { RelationMetadata } from "typeorm/metadata/RelationMetadata";
import { EmbeddedMetadata } from "typeorm/metadata/EmbeddedMetadata";
import {
  getLoaderIgnoredFields,
  getLoaderRequiredFields
} from "./ConfigureLoader";
import * as crypto from "crypto";

/**
 * Internal only class
 * Used for recursively traversing the GraphQL request and adding
 * the required selects and joins
 * @hidden
 */
export class GraphQLQueryResolver {
  private readonly _primaryKeyColumn?: string;
  private readonly _namingStrategy: LoaderNamingStrategyEnum;
  private _formatter: Formatter;
  private readonly _maxDepth: number;

  constructor({
    primaryKeyColumn,
    namingStrategy,
    maxQueryDepth
  }: LoaderOptions) {
    this._namingStrategy = namingStrategy ?? LoaderNamingStrategyEnum.CAMELCASE;
    this._primaryKeyColumn = primaryKeyColumn;
    this._formatter = new Formatter(this._namingStrategy);
    this._maxDepth = maxQueryDepth ?? Infinity;
  }

  private static _generateChildHash(
    alias: string,
    propertyName: string,
    length = 0
  ): string {
    const hash = crypto.createHash("md5");
    hash.update(`${alias}__${propertyName}`);

    const output = hash.digest("hex");

    if (length != 0) {
      return output.slice(0, length);
    }

    return output;
  }

  /**
   * Given a model and queryBuilder, will add the selected fields and
   * relations required by a graphql field selection
   * @param model
   * @param selection
   * @param connection
   * @param queryBuilder
   * @param alias
   * @param context
   * @param depth
   */
  public createQuery(
    model: Function | string,
    selection: Selection | null,
    connection: Connection,
    queryBuilder: SelectQueryBuilder<{}>,
    alias: string,
    context: any,
    depth = 0
  ): SelectQueryBuilder<{}> {
    const meta = connection.getMetadata(model);
    if (selection && selection.children) {
      const requiredFields = getLoaderRequiredFields(meta.target);
      const ignoredFields = getLoaderIgnoredFields(meta.target);
      const fields = meta.columns.filter(
        field =>
          !ignoredFields.get(field.propertyName) &&
          (field.isPrimary ||
            field.propertyName in selection.children! ||
            requiredFields.get(field.propertyName))
      );

      const embeddedFields = meta.embeddeds.filter(
        embed =>
          !ignoredFields.get(embed.propertyName) &&
          (embed.propertyName in selection.children! ||
            requiredFields.get(embed.propertyName))
      );

      queryBuilder = this._selectFields(queryBuilder, fields, alias);

      queryBuilder = this._selectEmbeddedFields(
        queryBuilder,
        embeddedFields,
        selection.children,
        meta,
        alias
      );

      // queryBuilder = this._selectRequiredFields(
      //   queryBuilder,
      //   selection.children,
      //   alias,
      //   meta,
      //   context
      // );

      if (depth < this._maxDepth) {
        queryBuilder = this._selectRelations(
          queryBuilder,
          selection.children,
          meta.relations,
          alias,
          meta,
          connection,
          depth
        );
      }
    }
    return queryBuilder;
  }

  /**
   * Given a list of EmbeddedField metadata and the current selection set,
   * will find any GraphQL fields that map to embedded entities on the current
   * TypeORM model and add them to the SelectQuery
   * @param queryBuilder
   * @param embeddedFields
   * @param children
   * @param meta
   * @param alias
   * @private
   */
  private _selectEmbeddedFields(
    queryBuilder: SelectQueryBuilder<{}>,
    embeddedFields: Array<EmbeddedMetadata>,
    children: Hash<Selection>,
    meta: EntityMetadata,
    alias: string
  ) {
    const embeddedFieldsToSelect: Array<Array<string>> = [];
    const requiredFields = getLoaderRequiredFields(meta.target);
    embeddedFields.forEach(field => {
      // This is the name of the embedded entity on the TypeORM model
      const embeddedFieldName = field.propertyName;

      // If the embed was required, just select everything
      if (requiredFields.get(embeddedFieldName)) {
        embeddedFieldsToSelect.push(
          field.columns.map(
            ({ propertyName }) => `${embeddedFieldName}.${propertyName}`
          )
        );

        // Otherwise check if this particular field was queried for in GraphQL
      } else if (children.hasOwnProperty(embeddedFieldName)) {
        const embeddedSelection = children[embeddedFieldName];
        // Extract the column names from the embedded field
        // so we can compare it to what was requested in the GraphQL query
        const embeddedFieldColumnNames = field.columns.map(
          column => column.propertyName
        );
        // Filter out any columns that weren't requested in GQL
        // and format them in a way that TypeORM can understand.
        // The query builder api requires we query like so:
        // .addSelect('table.embeddedField.embeddedColumn')
        embeddedFieldsToSelect.push(
          embeddedFieldColumnNames
            .filter(columnName => columnName in embeddedSelection.children!)
            .map(columnName => `${embeddedFieldName}.${columnName}`)
        );
      }
    });

    // Now add each embedded select statement on to the query builder
    embeddedFieldsToSelect.flat().forEach(field => {
      queryBuilder = queryBuilder.addSelect(
        this._formatter.columnSelection(alias, field)
      );
    });
    return queryBuilder;
  }

  /**
   * Given a set of fields, adds them as a select to the
   * query builder if they exist on the entity.
   * @param queryBuilder
   * @param fields
   * @param alias
   * @private
   */
  private _selectFields(
    queryBuilder: SelectQueryBuilder<{}>,
    fields: Array<ColumnMetadata>,
    alias: string
  ): SelectQueryBuilder<{}> {
    // TODO Remove in 2.0
    // Ensure we select the primary key column
    queryBuilder = this._selectPrimaryKey(queryBuilder, fields, alias);

    // Add a select for each field that was requested in the query
    fields.forEach(field => {
      // Make sure we account for embedded types
      const propertyName: string = field.propertyName;
      const databaseName: string = field.databaseName;
      queryBuilder = queryBuilder.addSelect(
        this._formatter.columnSelection(alias, propertyName),
        this._formatter.aliasField(alias, databaseName)
      );
    });
    return queryBuilder;
  }

  /**
   * Ensures that the primary key of each entity is selected.
   * This is to ensure that joins work properly
   * @param qb
   * @param fields
   * @param alias
   * @private
   * @deprecated The loader now uses the entity metadata to grab the primary key
   */
  private _selectPrimaryKey(
    qb: SelectQueryBuilder<{}>,
    fields: Array<ColumnMetadata>,
    alias: string
  ): SelectQueryBuilder<{}> {
    /**
     * The query builder will automatically include the primary key column
     * in it's selection. To avoid a breaking change, we'll still select a column
     * if the user provides it, but this will be removed in the next major version.
     */
    if (!this._primaryKeyColumn) {
      return qb;
    }

    // Did they already include the primary key column in their query?
    const queriedPrimaryKey = fields.find(
      field => field.propertyName === this._primaryKeyColumn
    );

    // This will have already been selected
    if (queriedPrimaryKey?.isPrimary) {
      return qb;
    }

    if (!queriedPrimaryKey) {
      // if not, add it so joins don't break
      return qb.addSelect(
        this._formatter.columnSelection(alias, this._primaryKeyColumn),
        this._formatter.aliasField(alias, this._primaryKeyColumn)
      );
    } else {
      return qb;
    }
  }

  /**
   * Joins any relations required to resolve the GraphQL selection.
   * will recursively call createQuery for each relation joined with
   * the subselection of fields required for that branch of the request.
   * @param queryBuilder
   * @param children
   * @param relations
   * @param alias
   * @param meta
   * @param connection
   * @param depth
   * @private
   */
  private _selectRelations(
    queryBuilder: SelectQueryBuilder<{}>,
    children: Hash<Selection>,
    relations: Array<RelationMetadata>,
    alias: string,
    meta: EntityMetadata,
    connection: Connection,
    depth: number
  ): SelectQueryBuilder<{}> {
    const requiredFields = getLoaderRequiredFields(meta.target);
    const ignoredFields = getLoaderIgnoredFields(meta.target);

    relations
      .filter(relation => !ignoredFields.get(relation.propertyName))
      .forEach(relation => {
        const isRequired: boolean = !!requiredFields.get(relation.propertyName);
        // Join each relation that was queried
        if (relation.propertyName in children || isRequired) {
          const childAlias = GraphQLQueryResolver._generateChildHash(
            alias,
            relation.propertyName,
            10
          );

          // For now, if a relation is required, we load the full entity
          // via leftJoinAndSelect. It does not recurse through the required
          // relation.
          queryBuilder = isRequired
            ? queryBuilder.leftJoinAndSelect(
                this._formatter.columnSelection(alias, relation.propertyName),
                childAlias
              )
            : queryBuilder.leftJoin(
                this._formatter.columnSelection(alias, relation.propertyName),
                childAlias
              );
          // Recursively call createQuery to select and join any subfields
          // from this relation
          queryBuilder = this.createQuery(
            relation.inverseEntityMetadata.target,
            children[relation.propertyName],
            connection,
            queryBuilder,
            childAlias,
            depth + 1
          );
        }
      });
    return queryBuilder;
  }

  private _selectRequiredFields(
    queryBuilder: SelectQueryBuilder<{}>,
    children: Hash<Selection>,
    alias: string,
    meta: EntityMetadata,
    context: any
  ): SelectQueryBuilder<{}> {
    const requiredFields = getLoaderRequiredFields(meta.target);
    const { columns, relations, embeddeds } = meta;

    requiredFields.forEach((predicate, key) => {
      // Find predicate
      const matchingPropertyName = ({
        propertyName
      }: ColumnMetadata | RelationMetadata | EmbeddedMetadata) =>
        propertyName === key;

      // Determine whether the field is required by invoking the provided predicate
      const isRequired =
        typeof predicate === "function"
          ? predicate(context, Object.keys(children))
          : predicate;

      let col: ColumnMetadata | undefined;
      let rel: RelationMetadata | undefined;
      let embed: EmbeddedMetadata | undefined;

      if (!isRequired) {
        return;
      } else if ((col = columns.find(matchingPropertyName))) {
        // Select Column
        const { propertyName, databaseName } = col;
        queryBuilder = queryBuilder.addSelect(
          this._formatter.columnSelection(alias, propertyName),
          this._formatter.aliasField(alias, databaseName)
        );
      } else if ((rel = relations.find(matchingPropertyName))) {
        // Join Relation
        const { propertyName } = rel;
        const childAlias = GraphQLQueryResolver._generateChildHash(
          alias,
          propertyName,
          10
        );
        queryBuilder.leftJoinAndSelect(
          this._formatter.columnSelection(alias, propertyName),
          childAlias
        );
      } else if ((embed = embeddeds.find(matchingPropertyName))) {
        // Select embed
        const { propertyName } = embed;
        queryBuilder.addSelect(
          this._formatter.columnSelection(alias, propertyName),
          this._formatter.aliasField(alias, propertyName)
        );
      }
    });
    return queryBuilder;
  }
}
